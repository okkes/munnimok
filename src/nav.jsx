import React from 'react';


export const DarkCtx = React.createContext({ dark: false, setDark: () => {} });
export const useDark = () => React.useContext(DarkCtx);
