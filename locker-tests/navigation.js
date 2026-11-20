export function guardSuiteNavigation(nav, isBusy, message) {
  if (!nav) return;
  const status = nav.querySelector(".suite-status");
  function check(event) {
    if (!event.target.closest("a[href]") || !isBusy()) return;
    event.preventDefault();
    status.textContent = message;
  }
  nav.addEventListener("click", check);
  nav.addEventListener("auxclick", check);
}
