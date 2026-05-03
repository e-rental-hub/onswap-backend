import { platformAPIClient } from "../config/platformAPIclient";

export const verifyPioneerToken = async (piAccessToken: string): Promise<{pioneerUid: string, pioneerUsername: string, kycVerified: boolean} | null> => {
  try {
    // Verify the user's access token with the /me endpoint:
    const me = await platformAPIClient.get(`/v2/me`, { 
      headers: { 'Authorization': `Bearer ${ piAccessToken }` }  
    });
    
    if (me && me.data) {
      const user = {
        pioneerUid: me.data.uid,
        pioneerUsername: me.data.username,
        kycVerified: me.data.kycVerified
      }

      console.log(`Pioneer found: ${user.pioneerUid} - ${user.pioneerUsername}`);
      return user;
    } else {
      console.warn("Pioneer not found.");
      return null;
    }
  } catch (err: any) {
    console.error('Failed to identify pioneer:', err);
    return null;
  }
};
  