document.documentElement.classList.add("js");

// Loader: play once per browser session, then lift away
(function () {
  const root = document.documentElement;
  const loader = document.getElementById("loader");
  if (!loader) return;

  let seen = false;
  try { seen = sessionStorage.getItem("loaderSeen") === "1"; } catch (e) {}

  if (seen) {
    root.classList.add("no-loader");
    return;
  }

  window.addEventListener("load", function () {
    setTimeout(function () {
      loader.classList.add("is-done");
      try { sessionStorage.setItem("loaderSeen", "1"); } catch (e) {}
    }, 1800);
  });
})();

// Fade elements in as they scroll into view
(function () {
  const items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach(function (el) { el.classList.add("is-visible"); });
    return;
  }

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.2 });

  items.forEach(function (el, i) {
    el.style.transitionDelay = i * 100 + "ms";
    observer.observe(el);
  });
})();

// Footer year
(function () {
  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
})();
