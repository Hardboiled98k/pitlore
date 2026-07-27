export async function processItems(items) {
  items.forEach(async (item) => {
    await saveItem(item);
  });
}
