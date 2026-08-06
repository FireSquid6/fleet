export const themeSeedScript =
	"try{if(localStorage.getItem('fleet-theme-seeded')===null){localStorage.setItem('fleet-theme-seeded','1');if(!localStorage.getItem('starlight-theme'))localStorage.setItem('starlight-theme','dark');}}catch(e){}";

export const themeApplyScript =
	"try{var t=localStorage.getItem('starlight-theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');}catch(e){}";
