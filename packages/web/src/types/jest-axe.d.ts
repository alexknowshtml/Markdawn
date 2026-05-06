declare module 'jest-axe' {
  interface AxeResults {
    violations: Array<{
      id: string;
      description: string;
      impact: string;
      nodes: Array<unknown>;
    }>;
    passes: Array<unknown>;
    incomplete: Array<unknown>;
    inapplicable: Array<unknown>;
  }

  function axe(element: Element | string): Promise<AxeResults>;

  export { axe };
}
