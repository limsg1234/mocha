#!/usr/bin/env node
'use strict';

const {loadImage} = require('canvas');
const {writeFile, mkdir, rmdir} = require('fs').promises;
const {resolve} = require('path');
const debug = require('debug')('mocha:docs:data:supporters');
const needle = require('needle');
const blocklist = new Set(require('./blocklist.json'));

const API_ENDPOINT = 'https://api.opencollective.com/graphql/v2';

const SPONSOR_TIER = 'sponsor';
const BACKER_TIER = 'backer';

const SUPPORTER_IMAGE_PATH = resolve(__dirname, '../images/supporters');

const SUPPORTER_QUERY = `query account($limit: Int, $offset: Int, $slug: String) {
  account(slug: $slug) {
    orders(limit: $limit, offset: $offset) {
      limit
      offset
      totalCount
      nodes {
        fromAccount {
          id
          name
          slug
          website
          imgUrlMed: imageUrl(height:64)
          imgUrlSmall: imageUrl(height:32)
          type
        }
        totalDonations {
          value
        }
        createdAt
      }
    }
  }
}`;

const GRAPHQL_PAGE_SIZE = 1000;

const invalidSupporters = [];

const nodeToSupporter = node => ({
  id: node.fromAccount.id,
  name: node.fromAccount.name,
  slug: node.fromAccount.slug,
  website: node.fromAccount.website,
  imgUrlMed: node.fromAccount.imgUrlMed,
  imgUrlSmall: node.fromAccount.imgUrlSmall,
  firstDonation: node.createdAt,
  totalDonations: node.totalDonations.value * 100,
  type: node.fromAccount.type
});

const fetchImage = async supporter => {
  try {
    const url = encodeURI(supporter.avatar);
    const {body: imageBuf} = await needle('get', url);
    debug('fetched %s', url);
    const canvasImage = await loadImage(imageBuf);
    debug('ok %s', url);
    supporter.dimensions = {
      width: canvasImage.width,
      height: canvasImage.height
    };
    debug('dimensions %s %dw %dh', url, canvasImage.width, canvasImage.height);
    const filePath = resolve(SUPPORTER_IMAGE_PATH, supporter.id + '.png');
    await writeFile(filePath, imageBuf);
    debug('wrote %s', filePath);
  } catch (err) {
    console.error(
      `failed to load ${supporter.avatar}; will discard ${supporter.tier} "${supporter.name} (${supporter.slug}). reason:\n`,
      err
    );
    invalidSupporters.push(supporter);
  }
};

/**
 * Retrieves donation data from OC
 *
 * Handles pagination
 * @param {string} slug - Collective slug to get donation data from
 * @returns {Promise<Object[]>} Array of raw donation data
 */
const getAllOrders = async (slug = 'mochajs') => {
  let allOrders = [];
  const variables = {limit: GRAPHQL_PAGE_SIZE, offset: 0, slug};

  // Handling pagination if necessary (2 pages for ~1400 results in May 2019)
  while (true) {
    const result = await needle(
      'post',
      API_ENDPOINT,
      {query: SUPPORTER_QUERY, variables},
      {json: true}
    );
    const orders = result.body.data.account.orders.nodes;
    allOrders = [...allOrders, ...orders];
    variables.offset += GRAPHQL_PAGE_SIZE;
    if (orders.length < GRAPHQL_PAGE_SIZE) {
      debug('retrieved %d orders', allOrders.length);
      return allOrders;
    } else {
      debug(
        'loading page %d of orders...',
        Math.floor(variables.offset / GRAPHQL_PAGE_SIZE)
      );
    }
  }
};

module.exports = async () => {
  const orders = await getAllOrders();
  // Deduplicating supporters with multiple orders
  const uniqueSupporters = new Map();

  const supporters = orders
    .map(nodeToSupporter)
    .filter(supporter => !blocklist.has(supporter.slug))
    .reduce((supporters, supporter) => {
      if (uniqueSupporters.has(supporter.slug)) {
        // aggregate donation totals
        uniqueSupporters.get(supporter.slug).totalDonations +=
          supporter.totalDonations;
        return supporters;
      }
      uniqueSupporters.set(supporter.slug, supporter);
      return [...supporters, supporter];
    }, [])
    .sort((a, b) => b.totalDonations - a.totalDonations)
    .reduce(
      (supporters, supporter) => {
        if (supporter.type === 'INDIVIDUAL') {
          if (supporter.name !== 'anonymous') {
            supporters.backers.push({
              ...supporter,
              avatar: supporter.imgUrlSmall,
              tier: BACKER_TIER
            });
          }
        } else {
          supporters.sponsors.push({
            ...supporter,
            avatar: supporter.imgUrlMed,
            tier: SPONSOR_TIER
          });
        }
        return supporters;
      },
      {sponsors: [], backers: []}
    );

  await rmdir(SUPPORTER_IMAGE_PATH, {recursive: true});
  debug('blasted %s', SUPPORTER_IMAGE_PATH);
  await mkdir(SUPPORTER_IMAGE_PATH, {recursive: true});
  debug('created %s', SUPPORTER_IMAGE_PATH);

  // Fetch images for sponsors and save their image dimensions
  await Promise.all([
    ...supporters.sponsors.map(fetchImage),
    ...supporters.backers.map(fetchImage)
  ]);

  invalidSupporters.forEach(supporter => {
    supporters[supporter.tier].splice(
      supporters[supporter.tier].indexOf(supporter),
      1
    );
  });

  debug(
    'found %d valid backers and %d valid sponsors (%d total; %d invalid)',
    supporters.backers.length,
    supporters.sponsors.length,
    supporters.backers.length + supporters.sponsors.length,
    invalidSupporters.length
  );
  return supporters;
};
