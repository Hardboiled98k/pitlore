export async function findUserById(id: string) {
  return db.query(`SELECT * FROM users WHERE id = ${id}`);
}
