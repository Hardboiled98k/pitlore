export async function findUserByName(name: string) {
  return db.query(`SELECT * FROM users WHERE name = '${name}'`);
}
