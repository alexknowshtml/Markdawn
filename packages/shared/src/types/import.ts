export interface LocalImagesNotImportedWarning {
  code: 'LOCAL_IMAGES_NOT_IMPORTED';
  count: number;
  message: string;
}

export type MarkdownImportWarning = LocalImagesNotImportedWarning;

export interface MarkdownImportedPage {
  id: string;
  title: string;
}

export interface MarkdownImportResult {
  page: MarkdownImportedPage;
  warnings: MarkdownImportWarning[];
}
