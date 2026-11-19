// Metro, configured for a pnpm monorepo.
//
// Two things are needed that the default does not do:
//
//  1. `watchFolders` must include the repo root, or Metro will not notice a
//     change in packages/shared and will serve a stale bundle.
//  2. `nodeModulesPaths` must include the root node_modules, because pnpm
//     puts most packages there rather than in the app's own folder, and
//     Metro's default resolver only walks upward from the project directory
//     in a way that misses pnpm's layout.
//
// Without these the app builds locally and then fails on a colleague's
// machine, which is the least useful kind of failure.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// The workspace packages ship TypeScript source, so Metro must not try to
// resolve a "main" that points at a build which does not exist for them.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
