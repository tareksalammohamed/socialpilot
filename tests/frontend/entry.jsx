import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.tsx';
export { React, act, createRoot, App };
export * from './supabase.js';
export { findVariantCalendar, loadContentPage, loadCalendarWeek, loadContentSummary } from '../../src/lib/contentQueries';

export { loadInboxPage, loadMessagePage, mergeInboxMessages } from '../../src/lib/inboxQueries';
