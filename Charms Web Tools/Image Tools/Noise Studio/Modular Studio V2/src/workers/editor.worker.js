import { createWorkerDomainHost } from './host.js';
import { editorTaskHandlers } from './tasks/editor.js';

createWorkerDomainHost('editor', editorTaskHandlers);
