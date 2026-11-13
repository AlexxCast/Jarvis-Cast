package com.jarvisfit.app

import com.jarvisfit.app.device.AppLauncher
import org.junit.Assert.assertEquals
import org.junit.Test

class AppLauncherTest {
    private val labels = listOf("YouTube Music", "YouTube", "WhatsApp", "Maps", "Spotify", "Calcolatrice")

    @Test fun exactNameWinsOverLongerOne() = assertEquals(1, AppLauncher.bestMatch("youtube", labels))
    @Test fun ignoresCaseSpacesAndAccents() = assertEquals(2, AppLauncher.bestMatch("Whats App", labels))
    @Test fun prefixMatches() = assertEquals(5, AppLauncher.bestMatch("calcola", labels))
    @Test fun longerRequestMatchesShorterLabel() = assertEquals(3, AppLauncher.bestMatch("Maps Google", labels))
    @Test fun unknownAppIsNotFound() = assertEquals(-1, AppLauncher.bestMatch("telegram", labels))
    @Test fun misheardNameFindsClosestApp() = assertEquals(4, AppLauncher.bestMatch("joytify", labels))
    @Test fun editDistance() = assertEquals(3, AppLauncher.distance("joytify", "spotify"))
    @Test fun tooShortQueryIsIgnored() = assertEquals(-1, AppLauncher.bestMatch("a", labels))
}
