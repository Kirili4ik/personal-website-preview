(() => {
  if (window.albumPlayerMounted || location.protocol === 'file:') return;
  window.albumPlayerMounted = true;
  const root = new URL(document.body.dataset.base || './', location.href);
  const audio = new Audio();
  audio.preload = 'none';
  audio.loop = true;
  audio.volume = 0;
  let tracks = {};
  try { tracks = JSON.parse(document.getElementById('player-config')?.textContent || '{}'); } catch {}
  let currentTrack = null, selectedDisc = null, userPaused = false, blocked = false;
  let pendingMusic = false, musicRequest = 0, navigationRequest = 0;
  let pageListeners = null, navigationController = null, fadeFrame = null, cancelInsertion = () => {};
  let finishInsertion = null;
  let navigationPending = false;
  let historySequence = 0, currentEntry = history.state?.albumEntry || 'initial';
  const readingPositions = new Map();
  history.replaceState({...history.state, albumEntry:currentEntry}, '', location.href);
  const phone = window.matchMedia?.('(max-width: 640px)');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function stopFade() {
    if (fadeFrame !== null) cancelAnimationFrame(fadeFrame);
    fadeFrame = null;
  }

  function updateControls() {
    const paused = userPaused || blocked || audio.paused;
    document.querySelectorAll('[data-player-track]').forEach(label => {
      label.textContent = !currentTrack ? 'Music off' : paused ? 'Music paused' : `${selectedDisc === 'work' ? 'Work' : 'Life'} music`;
    });
    document.querySelectorAll('[data-player-pause]').forEach(button => {
      button.hidden = !currentTrack;
      button.textContent = paused ? 'Resume music' : 'Pause music';
    });
    document.querySelectorAll('[data-player-mute]').forEach(button => {
      button.hidden = !currentTrack;
      button.textContent = audio.muted ? 'Unmute' : 'Mute';
      button.setAttribute('aria-pressed', String(audio.muted));
    });
  }

  function playMusic() {
    const request = musicRequest;
    blocked = false;
    try {
      Promise.resolve(audio.play()).catch(() => {
        if (request !== musicRequest) return;
        blocked = true;
        audio.pause();
        updateControls();
      });
    } catch {
      blocked = true;
      audio.pause();
    }
    updateControls();
  }

  function prepareMusic(disc) {
    selectedDisc = disc;
    const track = typeof tracks[disc] === 'string' && tracks[disc] ? new URL(tracks[disc], root).href : null;
    if (track === currentTrack) return;
    musicRequest++;
    stopFade();
    audio.pause();
    currentTrack = track;
    blocked = false;
    pendingMusic = Boolean(track);
    audio.volume = 0;
    if (track) {
      audio.src = track;
      audio.load();
      if (!userPaused) playMusic();
    }
    updateControls();
  }

  function seatMusic() {
    if (!pendingMusic) return;
    pendingMusic = false;
    try { audio.currentTime = 0; } catch {}
    const start = performance.now();
    const fade = now => {
      fadeFrame = null;
      if (userPaused || blocked || audio.paused) return;
      const progress = Math.min(1, (now-start)/300);
      audio.volume = .32 * progress;
      if (progress < 1) fadeFrame = requestAnimationFrame(fade);
    };
    fadeFrame = requestAnimationFrame(fade);
    if (currentTrack && !userPaused && !blocked && audio.paused) playMusic();
    updateControls();
  }

  function routeURL(href) {
    const url = new URL(href, location.href);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
    const path = url.pathname.slice(root.pathname.length);
    return /^(?:index\.html|(?:work|life|talks|collection)\/(?:index\.html)?)?$/.test(path) ? url : null;
  }

  function scrollPage(url, position) {
    const target = url.hash && document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (target) {
      for (let item = target; item; item = item.parentElement) if (item.tagName === 'DETAILS') item.open = true;
      target.scrollIntoView();
    } else window.scrollTo(...(position || [0,0]));
    const main = document.getElementById('main');
    if (main) { main.setAttribute('tabindex', '-1'); main.focus({preventScroll:true}); }
  }

  async function navigate(url, {pop = false, position = null} = {}) {
    const request = ++navigationRequest;
    navigationPending = true;
    navigationController?.abort();
    navigationController = new AbortController();
    try {
      const response = await fetch(url.href, {signal:navigationController.signal, credentials:'same-origin'});
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Page unavailable');
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (request !== navigationRequest) return;
      if (!next.querySelector('main#main')) throw new Error('Page unavailable');
      if (!pop) {
        readingPositions.set(currentEntry, [scrollX,scrollY]);
        history.replaceState({...history.state, albumScroll:[scrollX,scrollY]}, '', location.href);
        currentEntry = `${Date.now()}-${++historySequence}`;
        history.pushState({albumEntry:currentEntry, albumScroll:[0,0]}, '', url.href);
      }
      cancelInsertion();
      pageListeners?.abort();
      window.disposeAlbumInteractions?.();
      document.querySelectorAll('video, audio').forEach(media => { if (!media.paused) media.pause(); });
      next.querySelectorAll('script:not([type="application/json"])').forEach(script => script.remove());
      const body = document.importNode(next.body, true);
      document.title = next.title;
      document.body.replaceWith(body);
      window.mountAlbumInteractions?.();
      mountPlayer();
      scrollPage(url, position);
    } catch (error) {
      if (request === navigationRequest && error.name !== 'AbortError') location.assign(url.href);
    } finally {
      if (request === navigationRequest) navigationPending = false;
    }
  }

  function mountPlayer() {
    pageListeners?.abort();
    pageListeners = new AbortController();
    const options = {signal:pageListeners.signal};
    const viewer = document.querySelector('[data-player-scene]');
    if (viewer) {
      const stage = viewer.closest('[data-player-stage]');
      const configure = () => {
        const mode = phone?.matches ? 'Phone' : 'Desktop';
        const src = viewer.dataset[`player${mode}`];
        const poster = viewer.dataset[`playerPoster${mode}`];
        if (poster) viewer.setAttribute('poster', poster);
        for (const attribute of ['orbit','target']) {
          const value = viewer.dataset[`player${attribute[0].toUpperCase()+attribute.slice(1)}${mode}`];
          if (value) viewer.setAttribute(`camera-${attribute}`, value);
        }
        if (src && viewer.getAttribute('src') !== src) {
          stage?.classList.remove('is-ready');
          viewer.removeAttribute('data-player-failed');
          viewer.setAttribute('src', src);
        }
      };
      configure();
      phone?.addEventListener('change', () => { if (finishInsertion) finishInsertion(); else configure(); }, options);
      viewer.addEventListener('load', () => { viewer.hidden = false; stage?.classList.add('is-ready'); }, options);
      viewer.addEventListener('error', () => {
        viewer.dataset.playerFailed = '';
        viewer.hidden = true;
        stage?.classList.remove('is-ready');
        finishInsertion?.();
      }, options);
      if (viewer.dataset.playerLibrary && !document.querySelector('[data-sticker-library]') && !customElements.get('model-viewer')) {
        const library = document.createElement('script');
        library.type = 'module';
        library.src = viewer.dataset.playerLibrary;
        library.dataset.stickerLibrary = '';
        library.addEventListener('error', () => viewer.dispatchEvent(new Event('error')), options);
        document.head.append(library);
      }
    }
    updateControls();
  }

  function selectDisc(link, url) {
    cancelInsertion();
    navigationRequest++;
    navigationController?.abort();
    navigationPending = false;
    prepareMusic(link.dataset.disc);
    const viewer = document.querySelector('[data-player-scene]');
    const animation = link.dataset.disc === 'work' ? 'Insert_Work' : 'Insert_Life';
    const finish = () => {
      cancelInsertion();
      seatMusic();
      navigate(url);
    };
    const status = document.querySelector('[data-player-status]');
    if (status) status.textContent = `Opening ${link.dataset.disc === 'work' ? 'Work' : 'Life'}...`;
    if (!viewer?.loaded || viewer.hasAttribute('data-player-failed') || reducedMotion?.matches || !viewer.availableAnimations?.includes(animation)) {
      finish();
      return;
    }
    let timer;
    cancelInsertion = () => {
      clearTimeout(timer);
      viewer.removeEventListener('finished', finish);
      viewer.pause();
      finishInsertion = null;
      cancelInsertion = () => {};
    };
    finishInsertion = finish;
    viewer.animationName = animation;
    viewer.currentTime = 0;
    viewer.addEventListener('finished', finish, {once:true});
    const duration = Number.isFinite(viewer.duration) && viewer.duration > 0 ? viewer.duration : 3.8;
    timer = setTimeout(finish, duration * 1000 + 350);
    try { viewer.play({repetitions:1}); } catch { finish(); }
  }

  document.addEventListener('click', event => {
    const pause = event.target.closest('[data-player-pause]');
    if (pause && currentTrack) {
      stopFade();
      if (audio.paused || userPaused || blocked) {
        userPaused = false;
        audio.volume = pendingMusic ? 0 : .32;
        document.querySelectorAll('audio[data-classical]').forEach(media => { if (!media.paused) media.pause(); });
        playMusic();
      } else { userPaused = true; audio.pause(); updateControls(); }
      return;
    }
    if (event.target.closest('[data-player-mute]') && currentTrack) { audio.muted = !audio.muted; updateControls(); return; }
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download') || link.hasAttribute('data-document') || link.hasAttribute('data-contact')) return;
    const url = routeURL(link.href);
    if (!url || (url.pathname === location.pathname && url.search === location.search && !link.dataset.disc)) return;
    event.preventDefault();
    if (['work','life'].includes(link.dataset.disc)) selectDisc(link, url);
    else { cancelInsertion(); seatMusic(); navigate(url); }
  });
  document.addEventListener('play', event => {
    if (!event.target.matches?.('audio[data-classical]')) return;
    stopFade();
    userPaused = true;
    audio.pause();
    updateControls();
  }, true);
  audio.addEventListener('error', () => { stopFade(); blocked = true; audio.pause(); updateControls(); });
  window.addEventListener('popstate', event => {
    const url = routeURL(location.href);
    if (url) {
      if (!navigationPending) readingPositions.set(currentEntry, [scrollX,scrollY]);
      currentEntry = event.state?.albumEntry || location.href;
      cancelInsertion(); seatMusic();
      navigate(url, {pop:true, position:readingPositions.get(currentEntry) || event.state?.albumScroll});
    }
  });
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  mountPlayer();
})();
