// The site's own words (About, Join, Governance), kept under content/site/,
// apart from the engine. Public text adapted from the old site's pages.
import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';

export const collections = {
  site: defineCollection({ loader: glob({ pattern: '*.md', base: './content/site' }) }),
};
