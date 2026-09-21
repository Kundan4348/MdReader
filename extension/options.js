const theme = document.getElementById('theme'), disabled = document.getElementById('disabled'), status = document.getElementById('status');
chrome.storage.sync.get(['theme', 'disabled'], (o) => { theme.value = o.theme || 'paper'; disabled.checked = !!o.disabled; });
const saved = () => { status.textContent = 'Saved'; status.className = 'ok'; setTimeout(() => (status.textContent = ''), 1200); };
theme.onchange = () => chrome.storage.sync.set({ theme: theme.value }, saved);
disabled.onchange = () => chrome.storage.sync.set({ disabled: disabled.checked }, saved);
