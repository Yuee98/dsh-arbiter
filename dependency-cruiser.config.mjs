/** @satisfies {import('dependency-cruiser').IConfiguration} */
const configuration = {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      comment:
        'Runtime module cycles are forbidden. Type-only imports disappear before this graph is built.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // Read the same emit options as the build, but do not add erased type-only
    // edges back into the graph. This checks runtime dependencies only.
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: false,
    doNotFollow: { path: '(^|/)node_modules/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
    },
  },
};

export default configuration;
