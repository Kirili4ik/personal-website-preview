let libraryPromise;

export function loadLibrary() {
  return libraryPromise ||= fetch(new URL('./documents.json', import.meta.url)).then(response => {
    if (!response.ok) throw new Error('The document collection could not be loaded.');
    return response.json();
  });
}

export async function getDocumentFile(id) {
  const document = (await loadLibrary()).find(document => document.id === id);
  if (!document) throw new Error('Choose a document from Kirill\'s collection.');
  return new URL(document.file, import.meta.url).href;
}
