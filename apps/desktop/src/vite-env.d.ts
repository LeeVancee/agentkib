/** @jsxImportSource octane */

/// <reference types="vite/client" />

declare module "@octanejs/markdown/src/markdown-hooks.tsrx" {
  export const MarkdownHooks: any;
}

declare module "*.tsrx" {
  const component: any;
  export default component;
  export const MarkdownHooks: any;
}
