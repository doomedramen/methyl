/**
 * The vault tree's room id within a server vault. Each server vault is its
 * own room namespace (/sync/<vaultId>), so the tree room needs no vault id
 * of its own; it keeps the name every deployment before multi-vault used.
 * Browser vaults join it whatever their local id is.
 */
export const TREE_VAULT_ID = "local";
export const TREE_ROOM_ID = `vault:${TREE_VAULT_ID}`;
