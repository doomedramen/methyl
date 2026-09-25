import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceStore, TICKET_TTL_MS, readCookie } from "@/lib/server/devices";

const dirs: string[] = [];
const stores: DeviceStore[] = [];

function store(now?: () => number): DeviceStore {
  const dir = mkdtempSync(join(tmpdir(), "methyl-devices-"));
  dirs.push(dir);
  const s = new DeviceStore(join(dir, "server.db"), { now });
  stores.push(s);
  return s;
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DeviceStore", () => {
  it("verifies a paired device's cookie, and nothing else", () => {
    const devices = store();
    const { device, cookie } = devices.pair("Phone", ["personal"]);
    expect(devices.verify(cookie)?.id).toBe(device.id);
    const [id, secret] = cookie.split(".");
    expect(devices.verify(`${id}.${secret}x`)).toBeNull();
    expect(devices.verify(`not-a-device.${secret}`)).toBeNull();
    expect(devices.verify("garbage")).toBeNull();
  });

  it("stores only a hash of the secret", () => {
    const devices = store();
    const { cookie } = devices.pair("Laptop", "*");
    const secret = cookie.split(".")[1]!;
    // Reach into the database the way someone with the file would.
    const db = (devices as unknown as { db: { prepare(q: string): { all(): unknown[] } } }).db;
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain(secret);
  });

  it("a revoked device no longer verifies, and loses its tickets", () => {
    const devices = store();
    const { device, cookie } = devices.pair("Old tablet", "*");
    const { ticket } = devices.issueTicket(`device:${device.id}`, "personal");
    expect(devices.revoke(device.id)).toBe(true);
    expect(devices.verify(cookie)).toBeNull();
    expect(devices.redeemTicket(ticket, "personal", "conn-1")).toBeNull();
    expect(devices.list()).toEqual([]);
  });

  it("extend adds vaults to an existing device", () => {
    const devices = store();
    const { device } = devices.pair("Phone", ["personal"]);
    expect(devices.extend(device.id, ["work"])?.vaults).toEqual(["personal", "work"]);
    expect(devices.extend(device.id, "*")?.vaults).toBe("*");
  });

  it("a ticket is for one vault and one connection, and expires unless redeemed in time", () => {
    let now = 1_000_000;
    const devices = store(() => now);
    const { ticket } = devices.issueTicket("device:a", "personal");
    expect(devices.redeemTicket(ticket, "work", "conn-1")).toBeNull();
    expect(devices.redeemTicket(ticket, "personal", "conn-1")).toBe("device:a");
    // The same socket joins more rooms with it...
    expect(devices.redeemTicket(ticket, "personal", "conn-1")).toBe("device:a");
    // ...but no other socket can.
    expect(devices.redeemTicket(ticket, "personal", "conn-2")).toBeNull();
    devices.releaseConnection("conn-1");
    expect(devices.redeemTicket(ticket, "personal", "conn-1")).toBeNull();

    const late = devices.issueTicket("device:a", "personal").ticket;
    now += TICKET_TTL_MS + 1;
    expect(devices.redeemTicket(late, "personal", "conn-3")).toBeNull();
  });
});

describe("readCookie", () => {
  it("finds a cookie among others", () => {
    expect(readCookie("a=1; methyl_device=x.y; b=2", "methyl_device")).toBe("x.y");
    expect(readCookie("a=1", "methyl_device")).toBeNull();
    expect(readCookie(undefined, "methyl_device")).toBeNull();
  });
});
