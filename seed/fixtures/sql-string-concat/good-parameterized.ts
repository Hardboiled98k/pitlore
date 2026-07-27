export async function findUserByName(name: string) {
  return client.query(`SELECT id FROM users WHERE name = $1`, [name]);
}
