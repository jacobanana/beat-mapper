// The legacy modules are plain JS kept verbatim; the tests use them untyped.
declare module '*.legacy.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value: any;
  export default value;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const legacyUi: any;
}
