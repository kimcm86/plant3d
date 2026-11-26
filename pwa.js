/* PLANT 3D 앱 설치·업데이트 처리 */
(function () {
  const v = self.P3D_VERSION || '';
  const vb = document.getElementById('ver');
  if (vb) vb.textContent = 'v' + v;
  if (!('serviceWorker' in navigator) || !/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(location.href)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  function banner(w) {
    if (document.getElementById('upd')) return;
    const d = document.createElement('div');
    d.id = 'upd';
    d.innerHTML = '<span>새 버전이 준비되었습니다.</span><button>지금 업데이트</button>';
    d.querySelector('button').onclick = () => { d.querySelector('span').textContent = '업데이트 중…'; w.postMessage('update-now'); };
    document.body.appendChild(d);
  }
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) banner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) banner(w);
      });
    });
    // 앱을 켜둔 동안 1시간마다 새 버전 확인
    setInterval(() => reg.update().catch(() => {}), 3600 * 1000);
  }).catch(() => {});
})();
