'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('bitori', {
  init: () => ipcRenderer.invoke('bitori:init'),
  selectProfile: (name, modelOverride) => ipcRenderer.invoke('bitori:profile', name, modelOverride),
  listModels: name => ipcRenderer.invoke('bitori:models', name),
  chooseWorkspace: () => ipcRenderer.invoke('bitori:workspace'),
  send: text => ipcRenderer.invoke('bitori:send', text),
  cancel: () => ipcRenderer.invoke('bitori:cancel'),
  newSession: () => ipcRenderer.invoke('bitori:new-session'),
  switchSession: id => ipcRenderer.invoke('bitori:switch-session', id),
  renameSession: (id, title) => ipcRenderer.invoke('bitori:rename-session', id, title),
  deleteSession: id => ipcRenderer.invoke('bitori:delete-session', id),
  listSessions: () => ipcRenderer.invoke('bitori:sessions'),
  commands: () => ipcRenderer.invoke('bitori:commands'),
  openExternal: url => ipcRenderer.invoke('bitori:external', url),
  setZoom: factor => ipcRenderer.invoke('bitori:zoom', factor),
  decideApproval: (decision, callId) => ipcRenderer.invoke('bitori:approval', decision, callId),
  undoEdit: path => ipcRenderer.invoke('bitori:undo', path),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bitori:state', listener);
    return () => ipcRenderer.removeListener('bitori:state', listener);
  },
  onZoom: callback => {
    const listener = (_event, factor) => callback(factor);
    ipcRenderer.on('bitori:zoom', listener);
    return () => ipcRenderer.removeListener('bitori:zoom', listener);
  },
});
