declare const db: {
  project: {
    findMany(args: {
      where: { tenantId?: string; archived: boolean };
    }): Promise<unknown[]>;
  };
};

export function listActiveProjects() {
  return db.project.findMany({
    where: {
      archived: false,
    },
  });
}
