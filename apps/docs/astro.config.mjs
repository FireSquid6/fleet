// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { themeSeedScript } from './src/theme-boot.js';

const plainCodeThemes = [
	{
		name: 'fleet-plain-dark',
		type: 'dark',
		colors: { 'editor.background': '#12151a', 'editor.foreground': '#ced5de' },
		settings: [],
	},
	{
		name: 'fleet-plain-light',
		type: 'light',
		colors: { 'editor.background': '#f3f3f1', 'editor.foreground': '#31373d' },
		settings: [],
	},
];

// https://astro.build/config
export default defineConfig({
	// Set `site` to the deployed origin to enable sitemap generation; Starlight
	// skips the sitemap (with a build warning) while it is unset.
	// site: 'https://example.com',
	integrations: [
		starlight({
			title: 'fleet',
			description:
				'Fleet runs coding agents in isolated git workspaces, spread across one machine or many.',
			customCss: ['./src/styles/fleet.css'],
			// The web client is dark-first; seed Starlight's theme storage to dark
			// on a visitor's very first load so the docs open dark too. A one-shot
			// flag means we never override a returning visitor's own choice
			// (including "Auto"). The toggle still works normally afterwards.
			head: [
				{
					tag: 'script',
					content: themeSeedScript,
				},
			],
			tableOfContents: false,
			expressiveCode: {
				themes: plainCodeThemes,
				styleOverrides: {
					borderRadius: '0',
					borderWidth: '1px',
					borderColor: 'var(--line)',
					codeBackground: 'var(--panel)',
					codeFontFamily: 'var(--font-mono)',
					codeFontSize: '13.5px',
					codeLineHeight: '1.55',
					codePaddingBlock: '12px',
					codePaddingInline: '14px',
					uiFontFamily: 'var(--font-mono)',
					uiFontSize: '13px',
					frames: { shadowColor: 'transparent' },
				},
				defaultProps: { frame: 'none' },
				frames: { showCopyToClipboardButton: false },
			},
			components: {
				SocialIcons: './src/components/SocialLinks.astro',
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/firesquid6/fleet' },
			],
			editLink: {
				baseUrl: 'https://github.com/firesquid6/fleet/edit/main/apps/docs/',
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'start/introduction' },
						{ label: 'Installation', slug: 'start/installation' },
						{ label: 'Quickstart', slug: 'start/quickstart' },
					],
				},
				{
					label: 'Concepts',
					items: [{ autogenerate: { directory: 'concepts' } }],
				},
				{
					label: 'Guides',
					items: [{ autogenerate: { directory: 'guides' } }],
				},
				{
					label: 'Reference',
					items: [{ autogenerate: { directory: 'reference' } }],
				},
				{
					label: 'Packages',
					items: [{ autogenerate: { directory: 'packages' } }],
				},
				{
					label: 'Contributing',
					items: [{ autogenerate: { directory: 'contributing' } }],
				},
			],
		}),
	],
});
