const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../config/database');
const authenticate = require('../middleware/authenticate');

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function serializeUser(user) {
  return {
    _id: user.id,
    name: user.full_name,
    email: user.email,
    displayPictureUrl: user.display_picture_url,
    verified: user.verified,
  };
}

// Update name
router.post('/profile', authenticate, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ message: 'Name must be at least 2 characters long' });
    }

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({ full_name: name.trim(), updated_at: new Date().toISOString() })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error || !updatedUser) {
      console.error('Profile update error:', error);
      return res.status(500).json({ message: 'Failed to update profile' });
    }

    res.json({ message: 'Profile updated successfully', user: serializeUser(updatedUser) });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Change password (requires the current password)
router.post('/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }
    if (!/\d/.test(newPassword)) {
      return res.status(400).json({ message: 'Password must contain at least one number' });
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)) {
      return res.status(400).json({ message: 'Password must contain at least one special character' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isCurrentValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentValid) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const { error: updateError } = await supabase
      .from('users')
      .update({ password: hashedPassword, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) {
      console.error('Password update error:', updateError);
      return res.status(500).json({ message: 'Failed to update password' });
    }

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update profile picture. No file-storage bucket is configured yet, so the
// image is stored inline as a data URI — same tradeoff the app already makes
// for wardrobe photos sent to /api/wardrobe/analyze.
router.post('/avatar', authenticate, async (req, res) => {
  try {
    const { image, mimeType } = req.body;

    if (!image || typeof image !== 'string') {
      return res.status(400).json({ message: 'image (base64) is required' });
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
      return res.status(400).json({
        message: `mimeType must be one of: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`,
      });
    }

    const dataUri = `data:${mimeType};base64,${image}`;

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({ display_picture_url: dataUri, updated_at: new Date().toISOString() })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error || !updatedUser) {
      console.error('Avatar update error:', error);
      return res.status(500).json({ message: 'Failed to update profile picture' });
    }

    res.json({
      message: 'Profile picture updated successfully',
      user: serializeUser(updatedUser),
    });
  } catch (error) {
    console.error('Update avatar error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
