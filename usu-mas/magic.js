// Request Information form on the admissions page.
// When the form is submitted, show a personalized thank-you message
// instead of leaving the page.
const form = document.getElementById("info-form");
const message = document.getElementById("form-message");

function showConfirmation(event) {
  // Stop the browser from sending the form to another page
  event.preventDefault();
  // Read what the visitor typed and chose
  const name = document.getElementById("full-name").value;
  const level = document.querySelector('input[name="level"]:checked').value;
  // Choose the next step based on undergraduate or graduate interest
  let nextStep;
  if (level === "graduate") {
    nextStep =
      "A graduate admissions counselor will email you within two business days with current research areas and faculty who are accepting new students.";
  } else {
    nextStep =
      "An undergraduate admissions counselor will email you within two business days with upcoming information session dates and a campus visit guide.";
  }
  // Put the message on the page and show it
  message.textContent =
    "Thank you, " + name + "! Your request is on its way. " + nextStep;
  message.hidden = false;
}

form.addEventListener("submit", showConfirmation);
