declare const db: {
  project: {
    findMany(args: {
      where: { tenantId: string; archived: boolean };
    }): Promise<unknown[]>;
  };
};

export function listActiveProjects(tenantId: string) {
  return db.project.findMany({
    where: {
      tenantId,
      archived: false,
    },
  });
}
