import './ui/styles.css';
import { SubwaySightApp } from './app';

const appEl = document.getElementById('app');

if (appEl) {
  appEl.textContent = '';
  const app = new SubwaySightApp(appEl);

  window.addEventListener(
    'beforeunload',
    () => {
      app.dispose();
    },
    { once: true },
  );
}
