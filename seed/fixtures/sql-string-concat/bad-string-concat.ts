export function findAccount(accountId: string) {
  return database.execute("SELECT * FROM accounts WHERE id = " + accountId);
}
