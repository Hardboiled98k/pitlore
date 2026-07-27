export async function summarize(where: string[], values: unknown[]) {
  return pool.query(
    `SELECT kind, count(*)::integer AS count
       FROM registry_usage_events
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY kind`,
    values,
  );
}
