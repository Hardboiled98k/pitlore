export function findUser(userId: string) {
  return database.execute("SELECT * FROM users WHERE id = " + userId);
}
