// Authentication State
const authState = {
    isLoggedIn: false,
    user: null
};

// DOM Elements for Auth
const authModal = document.getElementById('auth-modal');
const loginSignupBtn = document.getElementById('login-signup-btn');
const closeModalBtn = document.getElementById('close-modal');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const showSignupLink = document.getElementById('show-signup');
const showLoginLink = document.getElementById('show-login');
const loginSubmit = document.getElementById('login-submit');
const signupSubmit = document.getElementById('signup-submit');
const logoutBtn = document.getElementById('logout-btn');
const logoutModal = document.getElementById('logout-modal');
const logoutConfirmBtn = document.getElementById('logout-confirm');
const logoutCancelBtn = document.getElementById('logout-cancel');
const authSection = document.getElementById('auth-section');
const userProfile = document.getElementById('user-profile');
const userGreeting = document.getElementById('user-greeting');
const heroCta = document.getElementById('hero-cta');
const authRequiredBtn = document.getElementById('auth-required-btn');

// Transfer Section Elements
const transferSection = document.getElementById('transfer');
const authRequired = document.getElementById('auth-required');
const transferContent = document.getElementById('transfer-content');
const homeSection = document.getElementById('home');
const howItWorksSection = document.getElementById('how-it-works');

// Initialize Auth
function initAuth() {
    // Check if user is already logged in (from localStorage)
    const savedUser = localStorage.getItem('musikTransferUser');
    if (savedUser) {
        authState.user = JSON.parse(savedUser);
        authState.isLoggedIn = true;
        updateUIForLoggedInUser();
    }

    // Event Listeners
    if (loginSignupBtn) loginSignupBtn.addEventListener('click', openAuthModal);
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeAuthModal);
    if (authModal) {
        authModal.querySelector('.modal-overlay')?.addEventListener('click', closeAuthModal);
    }
    if (showSignupLink) {
        console.log('Setting up signup link listener');
        showSignupLink.addEventListener('click', switchToSignup);
    }
    if (showLoginLink) {
        console.log('Setting up login link listener');
        showLoginLink.addEventListener('click', switchToLogin);
    }
    if (loginSubmit) loginSubmit.addEventListener('click', handleLogin);
    if (signupSubmit) signupSubmit.addEventListener('click', handleSignup);
    if (logoutBtn) logoutBtn.addEventListener('click', showLogoutConfirmation);
    if (logoutConfirmBtn) logoutConfirmBtn.addEventListener('click', handleLogout);
    if (logoutCancelBtn) logoutCancelBtn.addEventListener('click', closeLogoutModal);
    if (heroCta) heroCta.addEventListener('click', handleHeroCTA);
    if (authRequiredBtn) authRequiredBtn.addEventListener('click', openAuthModal);

    // Google login buttons
    const googleLoginBtn = document.getElementById('google-login');
    const googleSignupBtn = document.getElementById('google-signup');
    if (googleLoginBtn) googleLoginBtn.addEventListener('click', handleGoogleLogin);
    if (googleSignupBtn) googleSignupBtn.addEventListener('click', handleGoogleLogin);

    // Handle Google OAuth callback (redirect back from Google)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('google_connected') === 'true') {
        const token = urlParams.get('token');
        const userData = urlParams.get('user');

        if (token && userData) {
            try {
                const user = JSON.parse(decodeURIComponent(userData));
                // Store JWT token
                localStorage.setItem('musikTransferToken', token);
                if (typeof api !== 'undefined') {
                    api.setToken(token);
                }
                // Store user info
                authState.user = { name: user.name, email: user.email };
                authState.isLoggedIn = true;
                localStorage.setItem('musikTransferUser', JSON.stringify(authState.user));

                updateUIForLoggedInUser();
                showNotification('Signed in with Google as ' + user.name + '!', 'success');
            } catch (e) {
                console.error('Failed to parse Google user data:', e);
            }
        }
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    if (urlParams.get('error') === 'google_auth_failed') {
        showNotification('Google sign-in failed. Please try again.', 'error');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// Handle Google Login — real OAuth flow via backend
async function handleGoogleLogin(e) {
    if (e) e.preventDefault();

    const btn = e.target.closest('.btn-google');
    const originalContent = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Connecting to Google...';

    try {
        const response = await fetch('/api/auth/google');
        const data = await response.json();

        if (data.authUrl) {
            // Redirect to Google consent screen
            window.location.href = data.authUrl;
        } else {
            throw new Error('Failed to get Google auth URL');
        }
    } catch (error) {
        console.error('Google login error:', error);
        showNotification('Failed to connect to Google. Please try again.', 'error');
        btn.disabled = false;
        btn.innerHTML = originalContent;
    }
}

// Open Auth Modal
function openAuthModal(e) {
    if (e) e.preventDefault();
    console.log('Opening auth modal');
    authModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    // Ensure login form is shown first
    loginForm.style.display = 'block';
    signupForm.style.display = 'none';
}

// Close Auth Modal
function closeAuthModal(e) {
    if (e) e.preventDefault();
    authModal.style.display = 'none';
    document.body.style.overflow = 'auto';
}

// Switch to Signup Form
function switchToSignup(e) {
    if (e) e.preventDefault();
    console.log('Switching to signup form');
    loginForm.style.display = 'none';
    signupForm.style.display = 'block';
}

// Switch to Login Form
function switchToLogin(e) {
    if (e) e.preventDefault();
    console.log('Switching to login form');
    signupForm.style.display = 'none';
    loginForm.style.display = 'block';
}

// Handle Login
async function handleLogin(e) {
    e.preventDefault();

    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        showNotification('Please fill in all fields', 'error');
        return;
    }

    // Show loading state
    loginSubmit.disabled = true;
    loginSubmit.innerHTML = '<span class="button-icon">⏳</span> Logging in...';

    try {
        // Call real backend API
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'Login failed');
        }

        // Store JWT token for API calls
        if (data.token) {
            localStorage.setItem('musikTransferToken', data.token);
            // Update the API instance token
            if (typeof api !== 'undefined') {
                api.setToken(data.token);
            }
        }

        // Store user info for UI
        authState.user = { name: data.user.name, email: data.user.email };
        authState.isLoggedIn = true;
        localStorage.setItem('musikTransferUser', JSON.stringify(authState.user));

        updateUIForLoggedInUser();
        closeAuthModal();
        showNotification('Welcome back, ' + data.user.name + '!', 'success');

        // Clear form
        document.getElementById('login-email').value = '';
        document.getElementById('login-password').value = '';
    } catch (error) {
        console.error('Login error:', error);
        showNotification(error.message || 'Invalid email or password', 'error');
    } finally {
        loginSubmit.disabled = false;
        loginSubmit.innerHTML = 'LOG IN';
    }
}

// Handle Signup
async function handleSignup(e) {
    e.preventDefault();

    const name = document.getElementById('signup-name').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;

    if (!name || !email || !password) {
        showNotification('Please fill in all fields', 'error');
        return;
    }

    if (password.length < 6) {
        showNotification('Password must be at least 6 characters', 'error');
        return;
    }

    // Show loading state
    signupSubmit.disabled = true;
    signupSubmit.innerHTML = '<span class="button-icon">⏳</span> Creating Account...';

    try {
        // Call real backend API
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'Registration failed');
        }

        // Store JWT token for API calls
        if (data.token) {
            localStorage.setItem('musikTransferToken', data.token);
            // Update the API instance token
            if (typeof api !== 'undefined') {
                api.setToken(data.token);
            }
        }

        // Store user info for UI
        authState.user = { name: data.user.name, email: data.user.email };
        authState.isLoggedIn = true;
        localStorage.setItem('musikTransferUser', JSON.stringify(authState.user));

        updateUIForLoggedInUser();
        closeAuthModal();
        showNotification('Account created successfully! Welcome, ' + data.user.name + '!', 'success');

        // Clear form
        document.getElementById('signup-name').value = '';
        document.getElementById('signup-email').value = '';
        document.getElementById('signup-password').value = '';
    } catch (error) {
        console.error('Signup error:', error);
        showNotification(error.message || 'Failed to create account', 'error');
    } finally {
        signupSubmit.disabled = false;
        signupSubmit.innerHTML = 'CREATE ACCOUNT';
    }
}

// Show Logout Confirmation Modal
function showLogoutConfirmation(e) {
    if (e) e.preventDefault();
    if (logoutModal) {
        logoutModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
}

// Close Logout Modal
function closeLogoutModal(e) {
    if (e) e.preventDefault();
    if (logoutModal) {
        logoutModal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

// Handle Logout
function handleLogout(e) {
    if (e) e.preventDefault();

    closeLogoutModal();

    authState.user = null;
    authState.isLoggedIn = false;
    localStorage.removeItem('musikTransferUser');
    localStorage.removeItem('musikTransferToken');

    // Clear API token
    if (typeof api !== 'undefined') {
        api.setToken(null);
    }

    updateUIForLoggedOutUser();
    showNotification('You have been logged out', 'success');

    // Hide transfer section and show home
    if (transferSection) transferSection.style.display = 'none';
    if (homeSection) homeSection.style.display = 'block';
    if (howItWorksSection) howItWorksSection.style.display = 'block';

    // Redirect to home page
    window.location.href = 'index.html';
}

// Update UI for Logged In User
function updateUIForLoggedInUser() {
    loginSignupBtn.style.display = 'none';
    userProfile.style.display = 'flex';

    // Set greeting with user's name
    if (userGreeting && authState.user) {
        userGreeting.textContent = `Hi, ${authState.user.name}`;
    }

    // Switch view
    if (window.updateViewOnLogin) window.updateViewOnLogin(true);
}

// Update UI for Logged Out User
function updateUIForLoggedOutUser() {
    loginSignupBtn.style.display = 'block';
    userProfile.style.display = 'none';

    // Switch view
    if (window.updateViewOnLogin) window.updateViewOnLogin(false);
}

// Handle Hero CTA Click
function handleHeroCTA(e) {
    e.preventDefault();

    if (!authState.isLoggedIn) {
        openAuthModal();
        return;
    }

    // Show transfer section
    showTransferSection();
}

// Show Transfer Section
function showTransferSection() {
    if (!authState.isLoggedIn) {
        transferSection.style.display = 'block';
        authRequired.style.display = 'flex';
        transferContent.style.display = 'none';
        homeSection.style.display = 'none';
        howItWorksSection.style.display = 'none';

        // Scroll to transfer section
        transferSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        transferSection.style.display = 'block';
        authRequired.style.display = 'none';
        transferContent.style.display = 'grid';
        homeSection.style.display = 'none';
        howItWorksSection.style.display = 'none';

        // Scroll to transfer section
        transferSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Update navigation behavior
function setupNavigation() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href') || '';
            if (!href.startsWith('#') || href.length <= 1) {
                return;
            }
            e.preventDefault();
            const targetId = href.substring(1);

            if (targetId === 'home') {
                homeSection.style.display = 'block';
                howItWorksSection.style.display = 'block';
                transferSection.style.display = 'none';
                homeSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (targetId === 'how-it-works') {
                homeSection.style.display = 'block';
                howItWorksSection.style.display = 'block';
                transferSection.style.display = 'none';
                document.getElementById('how-it-works').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    setupNavigation();
});
