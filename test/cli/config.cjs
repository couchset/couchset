module.exports = {
  db: {
    definitions: () => [{name: 'Fixture'}],
    planCollections: async () => [{scope: '_default', collection: '_default', status: 'matching'}],
    planIndexes: async () => ({items: []}),
    planSearchIndexes: async () => ({items: []}),
    applyIndexPlan: async () => ({applied: true}),
    applySearchIndexPlan: async () => ({applied: true}),
    shutdown: async () => {},
  },
  eventing: {plan: async () => ({functions: [], staleOwnedFunctions: []})},
};
