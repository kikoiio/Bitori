'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('bitori', {
  init: () => ipcRenderer.invoke('bitori:init'),
  selectProfile: name => ipcRenderer.invoke('bitori:profile', name),
  chooseWorkspace: () => ipcRenderer.invoke('bitori:workspace'),
  send: text => ipcRenderer.invoke('bitori:send', text),
  cancel: () => ipcRenderer.invoke('bitori:cancel'),
  newSession: () => ipcRenderer.invoke('bitori:new-session'),
  switchSession: id => ipcRenderer.invoke('bitori:switch-session', id),
  listSessions: () => ipcRenderer.invoke('bitori:sessions'),
  decideApproval: decision => ipcRenderer.invoke('bitori:approval', decision),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bitori:state', listener);
    return () => ipcRenderer.removeListener('bitori:state', listener);
  },
});
