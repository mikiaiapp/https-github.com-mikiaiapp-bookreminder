export const sendEmail = async (to: string, subject: string, html: string) => {
  const emailUrl = process.env.CENTRAL_EMAIL_URL;
  const emailKey = process.env.CENTRAL_EMAIL_KEY;

  if (!emailUrl || !emailKey) {
    console.log(`\n[Cartero Mock] Email to ${to} | Subject: ${subject}`);
    console.log(`[Cartero Mock] Body: ${html}\n`);
    return;
  }
  
  try {
    // Determine the correct endpoint. If the URL already ends in /api/send, use it directly.
    // Otherwise, append /api/send as a reasonable default for a centralized mailer.
    const endpoint = emailUrl.endsWith('/api/send') ? emailUrl : `${emailUrl.replace(/\/$/, '')}/api/send`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': emailKey,
        'Authorization': `Bearer ${emailKey}`
      },
      body: JSON.stringify({
        to,
        subject,
        html,
        key: emailKey // Sending key in body as well, depending on how Cartero expects it
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Cartero Error] Failed to send email to ${to}. Status: ${response.status}. Response: ${errorText}`);
    } else {
      console.log(`[Cartero Success] Email sent to ${to}`);
    }
  } catch (error) {
    console.error("[Cartero Exception] Error sending email:", error);
  }
};
