(() => {
    const navToggle = document.querySelector(".nav-toggle");
    const navigation = document.querySelector(".site-nav");

    if (navToggle && navigation) {
        const setMenu = (open) => {
            navToggle.setAttribute("aria-expanded", String(open));
            navigation.classList.toggle("is-open", open);
            document.body.classList.toggle("menu-open", open);
        };

        navToggle.addEventListener("click", () => {
            setMenu(navToggle.getAttribute("aria-expanded") !== "true");
        });

        navigation.addEventListener("click", (event) => {
            if (event.target.closest("a")) setMenu(false);
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                setMenu(false);
                navToggle.focus();
            }
        });

        const desktopNavigation = window.matchMedia("(min-width: 901px)");
        const closeMenuOnDesktop = (event) => {
            if (event.matches) setMenu(false);
        };
        desktopNavigation.addEventListener?.("change", closeMenuOnDesktop);
    }

    const galleryImage = document.querySelector("[data-gallery-image]");
    const galleryCaption = document.querySelector("[data-gallery-caption]");
    const galleryFrame = document.querySelector(".gallery-frame");
    const galleryButtons = [...document.querySelectorAll("[data-gallery-src]")];

    if (galleryImage && galleryButtons.length) {
        galleryButtons.forEach((button) => {
            button.addEventListener("click", () => {
                if (button.getAttribute("aria-pressed") === "true") return;

                galleryFrame?.classList.add("is-changing");
                window.setTimeout(() => {
                    galleryImage.src = button.dataset.gallerySrc;
                    galleryImage.alt = button.dataset.galleryAlt || "";
                    if (galleryCaption) galleryCaption.textContent = button.dataset.galleryCaption || "";
                    galleryButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
                    galleryFrame?.classList.remove("is-changing");
                }, 160);
            });
        });
    }

    const modeSelector = document.querySelector(".mode-selector");
    const modeButtons = [...document.querySelectorAll("[data-mode-name]")];
    const modeName = document.querySelector("[data-mode-title]");
    const modeCopy = document.querySelector("[data-mode-output]");
    const modePanel = document.querySelector(".mode-detail");

    const selectMode = (button) => {
        modeButtons.forEach((item) => {
            item.setAttribute("aria-selected", String(item === button));
            item.tabIndex = item === button ? 0 : -1;
        });
        if (modeName) modeName.textContent = button.dataset.modeName;
        if (modeCopy) modeCopy.textContent = button.dataset.modeCopy;
        if (modePanel && button.id) modePanel.setAttribute("aria-labelledby", button.id);
        modeSelector?.style.setProperty("--mode-color", button.dataset.modeColor || "#f94f5e");
    };

    modeButtons.forEach((button, index) => {
        button.addEventListener("click", () => selectMode(button));
        button.addEventListener("keydown", (event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            let nextIndex = index;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % modeButtons.length;
            if (event.key === "ArrowLeft") nextIndex = (index - 1 + modeButtons.length) % modeButtons.length;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = modeButtons.length - 1;
            selectMode(modeButtons[nextIndex]);
            modeButtons[nextIndex].focus();
        });
    });

    const revealItems = document.querySelectorAll(".reveal");
    if ("IntersectionObserver" in window && revealItems.length) {
        const revealObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            });
        }, { threshold: 0.14 });
        revealItems.forEach((item) => revealObserver.observe(item));
    } else {
        revealItems.forEach((item) => item.classList.add("is-visible"));
    }
})();
