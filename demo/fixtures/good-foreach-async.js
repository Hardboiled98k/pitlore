export async function processItems(items) {
  await Promise.all(
    items.map(async (item) => {
      await saveItem(item);
    }),
  );
}
