(function () {
  try {
    var stored = localStorage.getItem("housetory-theme");
    var theme = stored === "light" || stored === "dark" ? stored : "system";
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = theme === "dark" || (theme === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (error) {
    document.documentElement.dataset.theme = "system";
  }
})();
