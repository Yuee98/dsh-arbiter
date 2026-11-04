import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AnnotationApp } from './web-app.js';
import { webTransport } from './web-api.js';
const element = document.getElementById('app');
if (element === null) throw new Error('missing annotation root');
createRoot(element).render(
  createElement(AnnotationApp, {
    transport: webTransport(location.hash.slice(1)),
  }),
);
