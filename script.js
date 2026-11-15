const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav-links');

menuButton.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
  nav.classList.toggle('open', !isOpen);
});

nav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open navigation');
    nav.classList.remove('open');
  });
});

document.querySelectorAll('.code-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.code-tab').forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    document.querySelectorAll('.code-panel').forEach((panel) => {
      const selected = panel.id === `panel-${tab.dataset.tab}`;
      panel.classList.toggle('active', selected);
      panel.hidden = !selected;
    });
  });
});

document.querySelector('.copy-button').addEventListener('click', async (event) => {
  const activeCode = document.querySelector('.code-panel:not([hidden]) code').innerText;
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(activeCode);
    button.innerHTML = 'COPIED <span>✓</span>';
    window.setTimeout(() => { button.innerHTML = 'COPY <span>▢</span>'; }, 1600);
  } catch {
    button.innerHTML = 'SELECT CODE <span>↖</span>';
    window.setTimeout(() => { button.innerHTML = 'COPY <span>▢</span>'; }, 1600);
  }
});
