import { app, BrowserWindow, session, shell } from 'electron';
import { resolveAppUrl } from './app-url.js';
import { hardenSession, isExternal } from './security.js';

const appUrl = resolveAppUrl(process.env, app.isPackaged);

function openOutside(url: string): void {
  if (/^https?:/.test(url)) void shell.openExternal(url);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'moj-n8n',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Anything leaving the app's origin (links, navigations, server redirects) opens in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url, appUrl)) openOutside(url);
    return { action: 'deny' };
  });
  const keepInsideApp = (event: { preventDefault(): void }, url: string) => {
    if (isExternal(url, appUrl)) {
      event.preventDefault();
      openOutside(url);
    }
  };
  window.webContents.on('will-navigate', (event) => keepInsideApp(event, event.url));
  window.webContents.on('will-redirect', (event) => keepInsideApp(event, event.url));

  void window.loadURL(appUrl);
}

void app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
