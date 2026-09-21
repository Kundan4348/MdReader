// Toolbar click opens the viewer page (pick / recent local files, full editor).
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }));
