// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	// Set `site` to the deployed origin to enable sitemap generation; Starlight
	// skips the sitemap (with a build warning) while it is unset.
	// site: 'https://example.com',
	integrations: [
		starlight({
			title: 'Fleet',
			description:
				'Fleet runs coding agents in isolated git workspaces, spread across one machine or many.',
			// Map the shared fleet-design tokens onto Starlight's theme.
			customCss: ['./src/styles/fleet.css'],
			// The web client is dark-first; seed Starlight's theme storage to dark
			// on a visitor's very first load so the docs open dark too. A one-shot
			// flag means we never override a returning visitor's own choice
			// (including "Auto"). The toggle still works normally afterwards.
			head: [
				{
					tag: 'script',
					content:
						"try{if(localStorage.getItem('fleet-theme-seeded')===null){localStorage.setItem('fleet-theme-seeded','1');if(!localStorage.getItem('starlight-theme'))localStorage.setItem('starlight-theme','dark');}}catch(e){}",
				},
			],
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
