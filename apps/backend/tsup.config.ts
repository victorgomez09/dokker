import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs'],           // Generamos CommonJS
    outExtension() {           // Forzamos la extensión .cjs
        return {
            js: '.cjs',
        }
    },
    bundle: true,
    clean: true,
    target: 'node20',
    platform: 'node',
    shims: false,              // En .cjs __dirname funciona nativamente

    external: [
        'bcrypt',
        '@mapbox/node-pre-gyp',
        'fsevents',
        'mock-aws-s3',
        'aws-sdk',
        'nock',
        'pg-native'
    ],

    noExternal: ['@dokploy/server'],

    loader: {
        '.html': 'text',
    },
});