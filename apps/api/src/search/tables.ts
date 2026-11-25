// ============================================================================
// ARCHIVE-SEARCH: the search index tables (0032), one per audience and kind.
//
// None has an audience column, so no WHERE clause can cross audiences: the only
// way to read another audience's text is to name its table. The names are here
// and nowhere else in src/search; every statement takes its table from
// SEARCH_TABLES[audience], and test/search/static.test.ts holds that no
// statement built for the public names the other audience's tables.
//
// Officers have no tables of their own: a search by an officer reads what
// members are given.
// ============================================================================
export const SEARCH_AUDIENCES = ['public', 'members'] as const;
export type SearchAudience = (typeof SEARCH_AUDIENCES)[number];

export const SEARCH_TABLES = {
  public: { item: 'search_item_public', page: 'search_page_public' },
  members: { item: 'search_item_members', page: 'search_page_members' },
} as const satisfies Record<SearchAudience, { item: string; page: string }>;
