// Test harness for Milkdown editor - exposes globals for Playwright QA
// This file provides window globals that the editor component will expose

export interface EditorTestHarness {
  getEditorMarkdown: () => string;
  insertMarkdown: (content: string) => void;
  replaceAllMarkdown: (content: string) => void;
}

// Extend the Window interface for TypeScript
declare global {
  interface Window {
    getEditorMarkdown: () => string;
    insertMarkdown: (content: string) => void;
    replaceAllMarkdown: (content: string) => void;
  }
}

// Placeholder implementations - will be replaced by MilkdownEditor
window.getEditorMarkdown = () => '';
window.insertMarkdown = () => {};
window.replaceAllMarkdown = () => {};
