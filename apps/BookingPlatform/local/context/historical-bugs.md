# BookingPlatform Historical Bugs

Track known defects and regressions to prioritize during exploratory testing.

*   **Critical Bug:** Booking flow is blocked by an intercepting element. A fixed element at the bottom of the page prevents the "Continue to details" button from being clicked, blocking the booking process.
*   **Medium Bug:** Intermittent failure to click "Sign in" link. The "Sign in" link on the homepage is sometimes not clickable, preventing users from accessing the login page. This could be due to rendering issues or problems with the click event handling.
- **High**: All "Book" links on the homepage are broken and don't navigate to the booking page.
- **Medium**: On the Login page, submitting with empty fields displays a misleading error message: "No user found with the entered email". It should have separate validations for empty email and password fields.
- **Medium**: On the Registration page, submitting with empty fields displays "Missing fields," but it doesn't specify which fields are missing.
- **Medium**: On the Forgot Password page, submitting an invalid email address silently fails.
- **Low**: The "Change Password" form on the Profile page provides no explicit error message when submitted with empty fields; it only highlights the "Current Password" field.
- **Low**: The "Install WL Booking" button on the homepage doesn't trigger a browser install prompt.
- **Low**: Consistent `apple-mobile-web-app-capable` warning in the console, suggesting potential iOS configuration issues.