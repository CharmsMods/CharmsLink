import { createWorkerDomainHost } from './host.js';
import { appLibraryTaskHandlers } from './tasks/appLibrary.js';

createWorkerDomainHost('app-library', appLibraryTaskHandlers);
