document.addEventListener('DOMContentLoaded', function() {
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');
    const navLinks = document.querySelectorAll('.nav-menu a');

    hamburger.addEventListener('click', function() {
        navMenu.classList.toggle('active');
        hamburger.classList.toggle('active');
        hamburger.setAttribute('aria-expanded', navMenu.classList.contains('active'));
    });

    // allow keyboard toggling (Enter / Space)
    hamburger.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navMenu.classList.toggle('active');
            hamburger.classList.toggle('active');
            hamburger.setAttribute('aria-expanded', navMenu.classList.contains('active'));
        }
    });

    navLinks.forEach(link => {
        link.addEventListener('click', function() {
            navMenu.classList.remove('active');
            hamburger.classList.remove('active');
            
            navLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
        });
    });

    window.addEventListener('scroll', function() {
        const navbar = document.querySelector('.navbar');
        const headerTop = document.querySelector('.header-top');
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
            if (headerTop) headerTop.classList.add('hide');
        } else {
            navbar.classList.remove('scrolled');
            if (headerTop) headerTop.classList.remove('hide');
        }
    });

    const sections = document.querySelectorAll('section[id]');
    
    function highlightNavOnScroll() {
        const scrollY = window.pageYOffset;
        
        sections.forEach(section => {
            const sectionHeight = section.offsetHeight;
            const sectionTop = section.offsetTop - 100;
            const sectionId = section.getAttribute('id');
            
            if (scrollY > sectionTop && scrollY <= sectionTop + sectionHeight) {
                navLinks.forEach(link => {
                    link.classList.remove('active');
                    if (link.getAttribute('href') === `#${sectionId}`) {
                        link.classList.add('active');
                    }
                });
            }
        });
    }
    
    window.addEventListener('scroll', highlightNavOnScroll);

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                const offsetTop = target.offsetTop - 70;
                window.scrollTo({
                    top: offsetTop,
                    behavior: 'smooth'
                });
            }
        });
    });

    const contactForm = document.querySelector('.contact-form');
    if (contactForm) {
        contactForm.addEventListener('submit', function(e) {
            e.preventDefault();
            alert('Thank you for your message! We will get back to you soon.');
            this.reset();
        });
    }

    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -100px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    document.querySelectorAll('.about-card, .research-card, .team-member, .resource-card').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(el);
    });

    // Lab Member Registration & Authorization System - Re-attach on sections load
    let authListenersAttached = false;
    let resourcesAuthInitialized = false;

    function attachAuthEventListeners() {
        if (authListenersAttached) return;
        authListenersAttached = true;
    }

    // New Authentication System
    function initResourcesAuth() {
        if (resourcesAuthInitialized) return;

        const authTabs = document.querySelectorAll('.auth-tab-btn');
        const signinPanel = document.getElementById('signinPanel');
        const signupPanel = document.getElementById('signupPanel');
        const resetRequestPanel = document.getElementById('resetRequestPanel');
        const resetPasswordPanel = document.getElementById('resetPasswordPanel');
        const signinForm = document.getElementById('signinForm');
        const signupForm = document.getElementById('signupForm');
        const resetRequestForm = document.getElementById('resetRequestForm');
        const resetPasswordForm = document.getElementById('resetPasswordForm');
        const approvalLinkSection = document.getElementById('approvalLinkSection');
        const resetLinkSection = document.getElementById('resetLinkSection');
        const memberDashboard = document.getElementById('memberDashboard');
        const resourcesContent = document.getElementById('resourcesContent');
        const authContainer = document.querySelector('.auth-container');
        const authTabsContainer = document.querySelector('.auth-tabs');
        const authFormsContainer = document.querySelector('.auth-forms');
        let authApiAvailable = true;
        let pendingResetToken = null;

        if (!authTabs.length) return;
        resourcesAuthInitialized = true;

        function uniqueUrls(urls) {
            return [...new Set(urls.filter(Boolean))];
        }

        function buildUrlCandidates(path) {
            const relativePath = path.replace(/^\//, '');
            return uniqueUrls([
                relativePath,
                `./${relativePath}`,
                `/${relativePath}`
            ]);
        }

        async function apiRequest(url, options = {}) {
            const response = await fetch(url, {
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    ...(options.headers || {})
                },
                ...options
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || 'Request failed.');
            }
            return payload;
        }

        async function apiRequestFromCandidates(urls, options = {}) {
            let lastError = null;
            for (const url of urls) {
                try {
                    return await apiRequest(url, options);
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError || new Error('Request failed.');
        }

        function toggleAuthView(tabName) {
            authTabs.forEach(tab => {
                const isActive = tab.getAttribute('data-tab') === tabName;
                tab.classList.toggle('active', isActive);
            });
            if (signinPanel) signinPanel.classList.toggle('active', tabName === 'signin');
            if (signupPanel) signupPanel.classList.toggle('active', tabName === 'signup');
            if (resetRequestPanel) resetRequestPanel.classList.toggle('active', tabName === 'reset-request');
            if (resetPasswordPanel) resetPasswordPanel.classList.toggle('active', tabName === 'reset-password');
        }

        function showApprovalState(link) {
            const approvalLinkInput = document.getElementById('approvalLinkInput');
            if (approvalLinkInput) {
                approvalLinkInput.value = link;
            }
            if (authTabsContainer) authTabsContainer.style.display = 'none';
            if (authFormsContainer) authFormsContainer.style.display = 'none';
            if (approvalLinkSection) approvalLinkSection.hidden = false;
            if (resetLinkSection) resetLinkSection.hidden = true;
        }

        function showResetLinkState(link) {
            const resetLinkInput = document.getElementById('resetLinkInput');
            if (resetLinkInput) {
                resetLinkInput.value = link;
            }
            if (authTabsContainer) authTabsContainer.style.display = 'none';
            if (authFormsContainer) authFormsContainer.style.display = 'none';
            if (approvalLinkSection) approvalLinkSection.hidden = true;
            if (resetLinkSection) resetLinkSection.hidden = false;
        }

        function showAuthPanels() {
            if (authContainer) authContainer.hidden = false;
            if (authTabsContainer) authTabsContainer.style.display = 'flex';
            if (authFormsContainer) authFormsContainer.style.display = 'block';
            if (approvalLinkSection) approvalLinkSection.hidden = true;
            if (resetLinkSection) resetLinkSection.hidden = true;
            if (memberDashboard) memberDashboard.hidden = true;
            if (resourcesContent) resourcesContent.hidden = true;
        }

        function showResources(user) {
            if (authContainer) authContainer.hidden = true;
            if (memberDashboard) {
                memberDashboard.hidden = false;
                document.getElementById('loggedInUserName').textContent = user.name;
                document.getElementById('loggedInUserEmail').textContent = user.email;
            }
            if (resourcesContent) resourcesContent.hidden = false;
            document.dispatchEvent(new CustomEvent('resourcesShown', {
                detail: { user }
            }));
        }

        function handleBackendUnavailable(message) {
            authApiAvailable = false;
            showAuthPanels();
            toggleAuthView('signin');
            if (message) {
                const notice = document.querySelector('#signinPanel .auth-note');
                if (notice) {
                    notice.textContent = message;
                }
            }
        }

        authTabs.forEach(tab => {
            tab.addEventListener('click', function() {
                toggleAuthView(this.getAttribute('data-tab'));
            });
        });

        const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
        if (forgotPasswordBtn) {
            forgotPasswordBtn.addEventListener('click', function() {
                showAuthPanels();
                toggleAuthView('reset-request');
            });
        }

        if (signupForm) {
            signupForm.addEventListener('submit', async function(e) {
                e.preventDefault();

                const name = document.getElementById('signupName').value.trim();
                const email = document.getElementById('signupEmail').value.trim().toLowerCase();
                const role = document.getElementById('signupRole').value.trim();
                const password = document.getElementById('signupPassword').value;
                const confirmPassword = document.getElementById('signupConfirmPassword').value;

                if (password !== confirmPassword) {
                    alert('Passwords do not match!');
                    return;
                }

                if (password.length < 8) {
                    alert('Password must be at least 8 characters long!');
                    return;
                }

                if (!authApiAvailable) {
                    alert('Member sign-in requires the Flask backend. Start the site with app.py to enable account access.');
                    return;
                }

                try {
                    const result = await apiRequestFromCandidates(buildUrlCandidates('api/auth/signup'), {
                        method: 'POST',
                        body: JSON.stringify({
                            name,
                            email,
                            role,
                            password,
                            confirmPassword
                        })
                    });

                    const subject = encodeURIComponent('Lab Member Access Approval Request');
                    const body = encodeURIComponent(
                        `Dear Dr. Ujjwal Mahajan,\n\n` +
                        `A new member has requested access to the PancreaSys Lab resources:\n\n` +
                        `Name: ${name}\n` +
                        `Email: ${email}\n` +
                        `Role: ${role}\n\n` +
                        `To approve this request, please click the following link:\n` +
                        `${result.approvalLink}\n\n` +
                        `Best regards,\n` +
                        `PancreaSys Lab Website`
                    );

                    signupForm.reset();
                    showApprovalState(result.approvalLink);
                    window.location.href = `mailto:${result.labHeadEmail}?subject=${subject}&body=${body}`;
                } catch (error) {
                    alert(error.message);
                }
            });
        }

        if (signinForm) {
            signinForm.addEventListener('submit', async function(e) {
                e.preventDefault();

                const email = document.getElementById('signinEmail').value.trim().toLowerCase();
                const password = document.getElementById('signinPassword').value;

                if (!authApiAvailable) {
                    alert('Member sign-in requires the Flask backend. Start the site with app.py to enable account access.');
                    return;
                }

                try {
                    const result = await apiRequestFromCandidates(buildUrlCandidates('api/auth/signin'), {
                        method: 'POST',
                        body: JSON.stringify({ email, password })
                    });
                    showResources(result.user);
                } catch (error) {
                    alert(error.message);
                }
            });
        }

        if (resetRequestForm) {
            resetRequestForm.addEventListener('submit', async function(e) {
                e.preventDefault();

                const email = document.getElementById('resetRequestEmail').value.trim().toLowerCase();

                if (!authApiAvailable) {
                    alert('Password reset requires the Flask backend. Start the site with app.py to enable account access.');
                    return;
                }

                try {
                    const result = await apiRequestFromCandidates(buildUrlCandidates('api/auth/request-password-reset'), {
                        method: 'POST',
                        body: JSON.stringify({ email })
                    });

                    resetRequestForm.reset();
                    showResetLinkState(result.resetLink);

                    const subject = encodeURIComponent('PancreaSys Lab password reset');
                    const body = encodeURIComponent(
                        `Use the link below to reset your PancreaSys Lab resources password:\n\n` +
                        `${result.resetLink}\n\n` +
                        `This link expires in ${(result.expiresInSeconds || 0) / 60} minutes.`
                    );
                    window.location.href = `mailto:${result.email}?subject=${subject}&body=${body}`;
                } catch (error) {
                    alert(error.message);
                }
            });
        }

        if (resetPasswordForm) {
            resetPasswordForm.addEventListener('submit', async function(e) {
                e.preventDefault();

                const password = document.getElementById('resetPasswordNew').value;
                const confirmPassword = document.getElementById('resetPasswordConfirm').value;

                if (!pendingResetToken) {
                    alert('Open a valid password reset link before setting a new password.');
                    return;
                }

                if (!authApiAvailable) {
                    alert('Password reset requires the Flask backend. Start the site with app.py to enable account access.');
                    return;
                }

                try {
                    const result = await apiRequestFromCandidates(buildUrlCandidates(`api/auth/reset-password/${encodeURIComponent(pendingResetToken)}`), {
                        method: 'POST',
                        body: JSON.stringify({ password, confirmPassword })
                    });
                    alert(result.message);
                    resetPasswordForm.reset();
                    pendingResetToken = null;
                    window.location.hash = '';
                    showAuthPanels();
                    toggleAuthView('signin');
                } catch (error) {
                    alert(error.message);
                }
            });
        }

        async function copyInputValue(inputId, button, defaultLabel) {
            const input = document.getElementById(inputId);
            if (!input) return;

            try {
                await navigator.clipboard.writeText(input.value);
            } catch (error) {
                input.select();
                document.execCommand('copy');
            }

            button.textContent = 'Copied!';
            setTimeout(() => {
                button.textContent = defaultLabel;
            }, 2000);
        }

        const copyLinkBtn = document.getElementById('copyLinkBtn');
        if (copyLinkBtn) {
            copyLinkBtn.addEventListener('click', function() {
                copyInputValue('approvalLinkInput', this, 'Copy');
            });
        }

        const copyResetLinkBtn = document.getElementById('copyResetLinkBtn');
        if (copyResetLinkBtn) {
            copyResetLinkBtn.addEventListener('click', function() {
                copyInputValue('resetLinkInput', this, 'Copy');
            });
        }

        const backToSigninBtn = document.getElementById('backToSigninBtn');
        if (backToSigninBtn) {
            backToSigninBtn.addEventListener('click', function() {
                showAuthPanels();
                toggleAuthView('signin');
            });
        }

        const backToSigninFromResetBtn = document.getElementById('backToSigninFromResetBtn');
        if (backToSigninFromResetBtn) {
            backToSigninFromResetBtn.addEventListener('click', function() {
                showAuthPanels();
                toggleAuthView('signin');
            });
        }

        const cancelResetRequestBtn = document.getElementById('cancelResetRequestBtn');
        if (cancelResetRequestBtn) {
            cancelResetRequestBtn.addEventListener('click', function() {
                showAuthPanels();
                toggleAuthView('signin');
            });
        }

        const cancelResetPasswordBtn = document.getElementById('cancelResetPasswordBtn');
        if (cancelResetPasswordBtn) {
            cancelResetPasswordBtn.addEventListener('click', function() {
                pendingResetToken = null;
                window.location.hash = '';
                showAuthPanels();
                toggleAuthView('signin');
            });
        }

        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async function() {
                try {
                    await apiRequestFromCandidates(buildUrlCandidates('api/auth/signout'), { method: 'POST' });
                } catch (error) {
                    alert(error.message);
                }
                location.reload();
            });
        }

        async function checkApprovalLink() {
            const hash = window.location.hash;
            if (hash.startsWith('#approve=')) {
                const token = hash.substring(9);
                try {
                    const result = await apiRequestFromCandidates(buildUrlCandidates(`api/auth/approve/${encodeURIComponent(token)}`), {
                        method: 'POST'
                    });
                    alert(result.message);
                    window.location.hash = '';
                } catch (error) {
                    alert(error.message);
                }
            }
        }

        function checkResetLink() {
            const hash = window.location.hash;
            if (!hash.startsWith('#reset=')) {
                pendingResetToken = null;
                return false;
            }

            pendingResetToken = decodeURIComponent(hash.substring(7));
            showAuthPanels();
            toggleAuthView('reset-password');
            return true;
        }

        async function restoreSession() {
            try {
                const result = await apiRequestFromCandidates(buildUrlCandidates('api/auth/session'));
                authApiAvailable = true;
                if (result.authenticated && result.user) {
                    showResources(result.user);
                } else {
                    showAuthPanels();
                    toggleAuthView(pendingResetToken ? 'reset-password' : 'signin');
                }
            } catch (error) {
                handleBackendUnavailable('Member sign-in is available when the site is served through the Flask backend.');
            }
        }

        checkApprovalLink().finally(function() {
            checkResetLink();
            restoreSession();
        });
    }

    // Attach event listeners now
    attachAuthEventListeners();

    // Re-attach when sections are loaded
    document.addEventListener('sectionsLoaded', function() {
        attachAuthEventListeners();
        initResourcesAuth();
    });

    // Back to top button functionality
    const backToTopBtn = document.getElementById('backToTop');

    window.addEventListener('scroll', function() {
        if (window.pageYOffset > 300) {
            backToTopBtn.classList.add('show');
        } else {
            backToTopBtn.classList.remove('show');
        }
    });

    backToTopBtn.addEventListener('click', function() {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });

    // Newsletter form functionality
    const newsletterForm = document.getElementById('newsletterForm');
    if (newsletterForm) {
        newsletterForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const emailInput = this.querySelector('input[type="email"]');
            const email = emailInput.value;

            alert(`Thank you for subscribing! We'll send updates to ${email}`);
            emailInput.value = '';
        });
    }
});

